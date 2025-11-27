use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                create table signal_message_media (
                    id uuid primary key,
                    signal_message_id int8 not null references signal_message(id) on delete cascade,
                    content_type text not null,
                    file_ext text null,
                    file_name text null,
                    size_bytes int8 not null,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );
                create index idx_signal_message_media_message_id on signal_message_media(signal_message_id);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                drop table if exists signal_message_media;
                "#,
            )
            .await?;
        Ok(())
    }
}
