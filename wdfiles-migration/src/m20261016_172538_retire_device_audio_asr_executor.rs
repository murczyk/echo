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
drop table if exists public.device_audio_asr_scheduler;
drop table if exists public.device_audio_asr_job;
alter table public.device_audio drop constraint if exists device_audio_asr_identity_key;
alter table public.device_audio drop constraint device_audio_automatic_result_check;
alter table public.device_audio add constraint device_audio_automatic_result_check check (
    (automatic_transcription is null and automatic_transcribed_at is null)
    or (automatic_transcribed_at is not null and isfinite(automatic_transcribed_at)
        and (automatic_transcription is null or automatic_transcription ~ '[^[:space:]]'))
);

"#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration("The retired private executor cannot be restored without its archived database snapshot".into()))
    }
}
