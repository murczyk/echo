use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                alter table system_settings
                    add column if not exists enable_audio_transcription boolean;

                update system_settings
                set enable_audio_transcription = false
                where enable_audio_transcription is null;

                alter table system_settings
                    alter column enable_audio_transcription set default false,
                    alter column enable_audio_transcription set not null;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                alter table system_settings
                    drop column if exists enable_audio_transcription;
                "#,
            )
            .await?;
        Ok(())
    }
}
