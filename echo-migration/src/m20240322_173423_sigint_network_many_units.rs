use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_network drop column unit_id;",
        )
        .await?;
        db.execute_unprepared("
create table sigint_network_unit (
    id bigserial primary key,
    network_id int8 references sigint_network(id) not null,
    unit_id int8 references sigint_unit(id) not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
").await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_network_unit;")
            .await?;
        db.execute_unprepared("alter table sigint_network add column unit_id int8 references sigint_unit(id) not null;").await?;
        Ok(())
    }
}
