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
create table attachment_search_change (
 singleton boolean primary key check(singleton),
 changed_at timestamp not null
);
insert into attachment_search_change values(true, clock_timestamp() at time zone 'utc');
create function attachment_search_media_changed() returns trigger language plpgsql as $$
begin
 if TG_OP='DELETE' then
   if not exists(select 1 from deleted_media) then
     return null;
   end if;
 end if;
 update attachment_search_change
 set changed_at=greatest(changed_at, clock_timestamp() at time zone 'utc')
 where singleton;
 return null;
end $$;
create trigger attachment_search_media_updated
 after update of file_name,signal_message_id on signal_message_media
 for each row when (new.file_name is distinct from old.file_name
   or new.signal_message_id is distinct from old.signal_message_id)
 execute function attachment_search_media_changed();
create trigger attachment_search_media_deleted after delete on signal_message_media
 referencing old table as deleted_media
 for each statement execute function attachment_search_media_changed();
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
drop trigger if exists attachment_search_media_deleted on signal_message_media;
drop trigger if exists attachment_search_media_updated on signal_message_media;
drop function if exists attachment_search_media_changed();
drop table attachment_search_change;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
