use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for sql in [
            r#"
                create index concurrently device_audio_asr_missing_created_idx
                    on public.device_audio (created_at, id)
                    where automatic_transcription is null;
            "#,
            r#"
                create index concurrently device_audio_asr_missing_device_created_idx
                    on public.device_audio (device_id, created_at, id)
                    where automatic_transcription is null;
            "#,
            r#"
                create index concurrently device_audio_asr_policy_pending_idx
                    on public.device_audio_asr_job (audio_id)
                    where state = 'policy_pending';
            "#,
            r#"
                create index concurrently device_audio_asr_backfill_item_outcome_idx
                    on public.device_audio_asr_backfill_item (run_id, outcome, reason_code)
                    include (audio_id)
                    where outcome in ('skipped', 'recovery_required');
            "#,
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!(
                        "at {}:{}: {error}",
                        file!(),
                        line!()
                    ))
                })?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for sql in [
            "drop index concurrently if exists public.device_audio_asr_backfill_item_outcome_idx;",
            "drop index concurrently if exists public.device_audio_asr_policy_pending_idx;",
            "drop index concurrently if exists public.device_audio_asr_missing_device_created_idx;",
            "drop index concurrently if exists public.device_audio_asr_missing_created_idx;",
        ] {
            manager
                .get_connection()
                .execute_unprepared(sql)
                .await
                .map_err(|error| {
                    DbErr::Migration(format!(
                        "at {}:{}: {error}",
                        file!(),
                        line!()
                    ))
                })?;
        }
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
