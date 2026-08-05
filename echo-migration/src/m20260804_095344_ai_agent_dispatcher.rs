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
create table ai_agent_dispatcher (
    id smallint primary key check (id = 1),
    host text not null,
    port integer not null check (port between 1 and 65535),
    ssh_user text not null,
    namespace text not null,
    last_tested_at timestamp without time zone,
    last_test_error text,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);
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
drop table if exists ai_agent_dispatcher;
                "#,
            )
            .await?;
        Ok(())
    }
}
