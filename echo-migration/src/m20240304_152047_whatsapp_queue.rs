use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table whatsapp_queue (
    id bigserial primary key,
    from_jid text not null,
    from_pushname text not null,
    group_jid text not null,
    timestamp timestamp without time zone not null,
    body text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
",
        )
        .await?;
        db.execute_unprepared(
            "
create table whatsapp_group (
    jid text primary key,
    owner_jid text not null,
    name text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
            ",
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table whatsapp_queue;").await?;
        db.execute_unprepared("drop table whatsapp_group;").await?;
        Ok(())
    }
}
