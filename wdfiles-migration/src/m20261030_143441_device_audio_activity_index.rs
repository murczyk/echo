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
create index concurrently device_audio_device_created_idx
    on public.device_audio (device_id, created_at desc)
    include (source_size_bytes);
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop index concurrently public.device_audio_device_created_idx;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
