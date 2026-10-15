use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create table attachment_search_message_change (
 message_id bigint primary key,
 changed_at timestamp not null
);
create index attachment_search_message_change_time_idx
 on attachment_search_message_change(changed_at, message_id);
alter table attachment_search_change add column tracked_from timestamp;

create function attachment_search_record_messages(message_ids bigint[])
returns void language sql as $$
 insert into attachment_search_message_change(message_id,changed_at)
 select message_id,clock_timestamp() at time zone 'utc'
 from (select distinct message_id from unnest(message_ids) ids(message_id)
       where message_id is not null) unique_ids
 on conflict(message_id) do update
 set changed_at=greatest(attachment_search_message_change.changed_at,excluded.changed_at);
$$;

create function attachment_search_track_media() returns trigger language plpgsql as $$
begin
 if TG_OP='UPDATE' and new.file_name is not distinct from old.file_name
   and new.signal_message_id is not distinct from old.signal_message_id then
   return null;
 end if;
 if TG_OP='INSERT' then
   perform attachment_search_record_messages(array[new.signal_message_id]);
 elsif TG_OP='DELETE' then
   perform attachment_search_record_messages(array[old.signal_message_id]);
 else
   perform attachment_search_record_messages(array[old.signal_message_id,new.signal_message_id]);
 end if;
 return null;
end $$;
create trigger attachment_search_track_media
 after insert or update or delete on signal_message_media
 for each row execute function attachment_search_track_media();

create function attachment_search_track_content() returns trigger language plpgsql as $$
declare
 media_ids uuid[];
 message_ids bigint[];
begin
 if TG_TABLE_NAME='attachment_document' and TG_OP='UPDATE' then
   if new.revision is not distinct from old.revision
     and new.media_id is not distinct from old.media_id then
     return null;
   end if;
 elsif TG_TABLE_NAME='attachment_chunk' and TG_OP='UPDATE' then
   if new.media_id is not distinct from old.media_id
     and new.revision is not distinct from old.revision
     and new.text is not distinct from old.text
     and new.member is not distinct from old.member
     and new.summary is not distinct from old.summary then
     return null;
   end if;
 end if;
 if TG_OP='INSERT' then
   media_ids := array[new.media_id];
 elsif TG_OP='DELETE' then
   media_ids := array[old.media_id];
 else
   media_ids := array[old.media_id,new.media_id];
 end if;
 select array_agg(distinct signal_message_id) into message_ids
 from signal_message_media where id=any(media_ids);
 perform attachment_search_record_messages(message_ids);
 return null;
end $$;
create trigger attachment_search_track_document
 after insert or update or delete on attachment_document
 for each row execute function attachment_search_track_content();
create trigger attachment_search_track_chunk
 after insert or update or delete on attachment_chunk
 for each row execute function attachment_search_track_content();

update attachment_search_change
 set tracked_from=clock_timestamp() at time zone 'utc' where singleton;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop trigger if exists attachment_search_track_chunk on attachment_chunk;
drop trigger if exists attachment_search_track_document on attachment_document;
drop trigger if exists attachment_search_track_media on signal_message_media;
drop function if exists attachment_search_track_content();
drop function if exists attachment_search_track_media();
drop function if exists attachment_search_record_messages(bigint[]);
drop table attachment_search_message_change;
alter table attachment_search_change drop column tracked_from;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
