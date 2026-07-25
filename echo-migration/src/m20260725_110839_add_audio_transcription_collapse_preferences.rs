use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table if exists user_settings
                add column if not exists duty_audio_transcription_collapsed boolean,
                add column if not exists analysis_audio_transcription_collapsed boolean;

            update user_settings
            set
                duty_audio_transcription_collapsed = coalesce(duty_audio_transcription_collapsed, false),
                analysis_audio_transcription_collapsed = coalesce(analysis_audio_transcription_collapsed, false)
            where
                duty_audio_transcription_collapsed is null
                or analysis_audio_transcription_collapsed is null;

            alter table if exists user_settings
                alter column duty_audio_transcription_collapsed set default false,
                alter column duty_audio_transcription_collapsed set not null,
                alter column analysis_audio_transcription_collapsed set default false,
                alter column analysis_audio_transcription_collapsed set not null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table if exists user_settings
                drop column if exists duty_audio_transcription_collapsed,
                drop column if exists analysis_audio_transcription_collapsed;
            "#,
        )
        .await?;
        Ok(())
    }
}
