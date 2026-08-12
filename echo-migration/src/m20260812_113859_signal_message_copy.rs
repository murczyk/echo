use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table signal_message
                add column if not exists parent_signal_message_id bigint
                    references signal_message(id) on delete set null;

            create index if not exists idx_signal_message_parent_id
                on signal_message(parent_signal_message_id);

            alter table signal_message_media
                add column if not exists storage_key text;

            update signal_message_media
            set storage_key = case
                when is_encrypted then substr(id::text, 1, 5) || '/' || id::text
                else substr(id::text, 1, 5) || '/' || id::text || '.plaintext'
            end
            where storage_key is null;
            
            create index if not exists idx_signal_message_media_storage_key
                on signal_message_media(storage_key);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists idx_signal_message_media_storage_key;
            alter table signal_message_media drop column if exists storage_key;
            drop index if exists idx_signal_message_parent_id;
            alter table signal_message drop column if exists parent_signal_message_id;
            "#,
        )
        .await?;
        Ok(())
    }
}
