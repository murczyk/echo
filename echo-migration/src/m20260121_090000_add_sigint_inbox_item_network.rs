use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            create table sigint_inbox_item_network (
                id bigserial primary key,
                sigint_inbox_item_id bigint not null REFERENCES sigint_inbox_item(id) ON DELETE CASCADE,
                sigint_network_id bigint not null REFERENCES sigint_network(id) ON DELETE CASCADE,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create table network_invalidation_task (
                id bigserial primary key,
                frequency text,
                sigint_inbox_item_id bigint REFERENCES sigint_inbox_item(id) ON DELETE set null,
                since_ts timestamp without time zone not null,
                till_ts timestamp without time zone not null,
                completed_at timestamp without time zone,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table network_invalidation_task;")
            .await?;
        db.execute_unprepared("drop table sigint_inbox_item_network;")
            .await?;
        Ok(())
    }
}
