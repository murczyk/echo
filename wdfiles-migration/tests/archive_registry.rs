use sea_orm::{
    ConnectionTrait, Database, DbBackend, Statement, TransactionTrait,
};

const SOURCE_SQL: &str = r#"do $fixture$
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

#[tokio::test]
async fn archive_members_have_stable_identity_and_inherited_directory_revisions(
) {
    let db = Database::connect(std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let tx = db.begin().await.unwrap();
    tx.execute_unprepared(SOURCE_SQL).await.unwrap();
    tx.execute_unprepared(r#"do $$
    declare
        source file_revision;
        job uuid := gen_random_uuid();
        child uuid := gen_random_uuid();
        directory uuid := gen_random_uuid();
        path ltree;
    begin
        select * into strict source from file_revision where revision=2;
        select hierarchy_path into strict path from file_entry where id=source.id;
        insert into file_archive(id,device_id,source_file_id,source_revision,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,root_id,depth,policy)
        select job,source.device_id,source.id,2,c.object_key,c.source_sha256,c.source_size_bytes,c.is_encrypted,job,1,'{}' from file_content c where c.file_id=source.id and c.revision=2;
        update file_archive set state='running',attempts=1,run_id=gen_random_uuid(),heartbeat_at=now(),first_started_at=now(),deadline=now()+interval '1 day' where id=job;
        insert into file_entry(id,device_id,parent_id,kind,name,hierarchy_path,revision,sync_id,archive_file_id,archive_relative_path,is_archive,created_at,updated_at)
        values(directory,source.device_id,source.id,'directory','empty',path||file_entry_uuid_label(directory),2,source.sync_id,source.id,'empty',false,now(),now()),
              (child,source.device_id,source.id,'file','report.pdf',path||file_entry_uuid_label(child),2,source.sync_id,source.id,'report.pdf',false,now(),now());
        insert into file_revision(id,revision,device_id,sync_id,name,origin_archive_id,is_archive,created_at)
        values(directory,2,source.device_id,source.sync_id,'empty',job,false,now()),
              (child,2,source.device_id,source.sync_id,'report.pdf',job,false,now());
        if (select count(*) from file_revision where origin_archive_id=job and revision=2)<>2 then raise exception 'missing snapshot'; end if;
        begin
            insert into file_entry(id,device_id,parent_id,kind,name,hierarchy_path,revision,sync_id,archive_file_id,archive_relative_path,created_at,updated_at)
            values(gen_random_uuid(),source.device_id,source.id,'file','report.pdf',path||file_entry_uuid_label(gen_random_uuid()),2,source.sync_id,source.id,'report.pdf',now(),now());
            raise exception 'duplicate archive identity accepted';
        exception when unique_violation then null; end;
    end $$"#).await.unwrap();
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn archive_schema_has_only_one_lifecycle_table() {
    let db = Database::connect(std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let row = db.query_one_raw(Statement::from_string(DbBackend::Postgres,
        "select count(*)::bigint as n from information_schema.tables where table_schema='public' and (table_name like 'file_archive%' or table_name='file_processing_slot')"))
        .await.unwrap().unwrap();
    assert_eq!(row.try_get::<i64>("", "n").unwrap(), 1);
}
