use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            DROP TABLE if exists sigint_inbox_item_metadata;
            create table sigint_inbox_item_metadata (
                id bigserial primary key,
                sigint_inbox_item_id bigint not null REFERENCES sigint_inbox_item(id) ON DELETE CASCADE,
                color_code text,
                call_group_id text,
                call_group_name text,
                sender_id text,
                sender_name text,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            DROP TABLE if exists sigint_inbox_item_metadata;",
        )
        .await?;
        Ok(())
    }
}
