use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table whatsapp_queue add column whatsapp_id text;",
        )
        .await?;
        db.execute_unprepared(
            "create table whatsapp_queue_attachment (
                id bigserial primary key,
                whatsapp_id text,
                path text not null,
                created_at timestamp with time zone default now()
            );",
        )
        .await?;
        // create index on whatsapp_queue_attachment.whatsapp_id
        db.execute_unprepared(
            "create index whatsapp_queue_attachment_whatsapp_id on whatsapp_queue_attachment(whatsapp_id);",
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table whatsapp_queue drop column whatsapp_id;",
        )
        .await?;
        db.execute_unprepared("drop table whatsapp_queue_attachment;")
            .await?;
        Ok(())
    }
}
