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
        manager.get_connection().execute_unprepared(r#"
alter table public.device_audio add column automatic_transcription_pending integer;
alter table public.device_audio add constraint device_audio_transcription_pending_nonnegative
    check (automatic_transcription_pending >= 0);
create index device_audio_transcription_pending_idx on public.device_audio(id)
    where automatic_transcription_pending is not null;
"#).await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
do $$ begin
    if exists (select 1 from public.device_audio where automatic_transcription_pending is not null) then
        raise exception 'Cannot discard pending transcription work';
    end if;
end $$;
drop index public.device_audio_transcription_pending_idx;
alter table public.device_audio drop column automatic_transcription_pending;
"#).await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
