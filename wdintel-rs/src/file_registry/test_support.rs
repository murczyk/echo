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
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, QueryFilter, TransactionTrait,
    sea_query::Expr,
};
use uuid::Uuid;

pub(crate) const ARCHIVE_SOURCE_SQL: &str = r#"do $fixture$
declare
    device uuid := gen_random_uuid();
    root uuid := gen_random_uuid();
    source uuid := gen_random_uuid();
    session uuid := gen_random_uuid();
    upload uuid := gen_random_uuid();
    object_key text;
begin
    object_key := 'device-file-content/' || device || '/' || source || '/1/' || upload;
    insert into file_sync_session (id,device_id,mode,status,next_batch_index,received_count,accepted_count,created_count,updated_count,rejected_count,created_at,updated_at)
    values (session,device,'automatic','open',0,0,0,0,0,0,now(),now());
    insert into file_entry (id,device_id,kind,name,hierarchy_path,created_at,updated_at)
    values (root,device,'directory','C:\',file_entry_uuid_label(root),now(),now());
    insert into file_entry (id,device_id,parent_id,kind,name,absolute_path,hierarchy_path,revision,sync_id,analysis_input_revision,created_at,updated_at)
    values (source,device,root,'file','archive.zip','C:\archive.zip',file_entry_uuid_label(root)||file_entry_uuid_label(source),2,session,1,now(),now());
    insert into file_revision (id,revision,device_id,sync_id,name,absolute_path,mime_type,extension,created_at,source_sequence,analysis_input_revision)
    values (source,1,device,session,'archive.zip','C:\archive.zip','application/zip','zip',now(),1,1),
           (source,2,device,session,'archive.zip','C:\archive.zip','application/zip','zip',now(),2,1);
    insert into file_content_upload (id,device_id,file_id,revision,created_by_login_id,upload_length,expected_sha256,object_key,status,created_at,last_activity_at,expires_at,hard_expires_at,next_cleanup_at)
    values (upload,device,source,1,gen_random_uuid(),1,decode(repeat('01',32),'hex'),object_key,'open',now(),now(),now()+interval '1 hour',now()+interval '1 day',now()+interval '1 hour');
    update file_content_upload set status='completed',next_cleanup_at=now() where id=upload;
    insert into file_content (file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at)
    values (source,1,upload,object_key,1,decode(repeat('01',32),'hex'),true,now());
    insert into file_content (file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at)
    values (source,2,upload,object_key,1,decode(repeat('01',32),'hex'),true,now());
    update file_entry set content_path=object_key where id=source;
end
$fixture$;
"#;

pub(crate) const ARCHIVE_PUBLICATION_SQL: &str = r#"do $fixture$
declare
    archive uuid := '00000000-0000-0000-0000-000000000101';
    job file_archive;
    source file_revision;
    path ltree;
    child uuid;
    member_name text;
    ordinal bigint := 0;
begin
    select * into strict job from file_archive where id=archive;
    select * into strict source from file_revision where id=job.source_file_id and revision=job.source_revision;
    select hierarchy_path into strict path from file_entry where id=job.source_file_id;
    update file_archive set state='running',attempts=1,run_id=gen_random_uuid(),heartbeat_at=now(),first_started_at=now(),deadline=now()+interval '1 day',declared_nodes=2 where id=archive;
    foreach member_name in array array['Report.txt','report.txt'] loop
        child := gen_random_uuid();
        insert into file_entry(id,device_id,parent_id,kind,name,hierarchy_path,archive_file_id,archive_relative_path,revision,sync_id,is_archive,created_at,updated_at)
        values(child,job.device_id,job.source_file_id,'file',member_name,path||file_entry_uuid_label(child),job.source_file_id,member_name,job.source_revision,source.sync_id,lower(member_name) like '%.zip',now(),now()) on conflict(archive_file_id,archive_relative_path,kind) do nothing;
        select id into strict child from file_entry where archive_file_id=job.source_file_id and archive_relative_path=member_name and kind='file';
        insert into file_revision(id,revision,device_id,sync_id,name,origin_archive_id,archive_member_index,is_archive,created_at)
        values(child,job.source_revision,job.device_id,source.sync_id,member_name,archive,ordinal,lower(member_name) like '%.zip',now());
        insert into file_content(file_id,revision,origin_archive_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at)
        values(child,job.source_revision,archive,'archive-test/'||archive||'/'||child,1,decode(repeat('01',32),'hex'),false,now());
        update file_entry set revision=job.source_revision,sync_id=source.sync_id,content_path='archive-test/'||archive||'/'||child,updated_at=now() where id=child and revision<=job.source_revision;
        ordinal:=ordinal+1;
    end loop;
    update file_archive set state='ready',heartbeat_at=null where id=archive;
end
$fixture$;
"#;

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
        is_archive: sea_orm::ActiveValue::NotSet,
        archive_member_index: sea_orm::ActiveValue::NotSet,
        origin_archive_id: sea_orm::ActiveValue::NotSet,
        id: Set(file.id),
        revision: Set(1),
        device_id: Set(file.device_id),
        sync_id: Set(sync_id),
        source_sequence: Set(Some(source_sequence)),
        analysis_input_revision: Set(Some(1)),
        name: Set(file.name.clone()),
        absolute_path: Set(file.absolute_path.clone()),
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

    // Explicit inserts/updates without RETURNING: callers may run this on a
    // schema migrated only partway, before later columns such as stats_epoch.
    file_content_upload::Entity::insert(file_content_upload::ActiveModel {
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
        stats_epoch: NotSet,
    })
    .exec_without_returning(db)
    .await
    .unwrap();
    file_content_upload::Entity::update_many()
        .col_expr(
            file_content_upload::Column::Status,
            Expr::value(FileContentUploadStatus::Completed),
        )
        .col_expr(
            file_content_upload::Column::NextCleanupAt,
            Expr::value(Some(now)),
        )
        .filter(file_content_upload::Column::Id.eq(upload_id))
        .exec(db)
        .await
        .unwrap();
    file_content::Entity::insert(file_content::ActiveModel {
        origin_archive_id: sea_orm::ActiveValue::NotSet,
        file_id: Set(file.id),
        revision: Set(revision),
        upload_id: Set(Some(upload_id)),
        object_key: Set(object_key.clone()),
        source_size_bytes: Set(1),
        source_sha256: Set(source_sha256),
        is_encrypted: Set(true),
        created_at: Set(now),
    })
    .exec_without_returning(db)
    .await
    .unwrap();
    db.execute_raw(sea_orm::Statement::from_sql_and_values(
        sea_orm::DbBackend::Postgres,
        "update file_entry set content_path=$2 where id=$1",
        [file.id.into(), object_key.clone().into()],
    ))
    .await
    .unwrap();

    object_key
}
