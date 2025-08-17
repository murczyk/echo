use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table sigint_callsign (
    id bigserial primary key,
    callsign text not null,
    position text not null,
    comment text not null,
    unit_id int8 references sigint_unit(id) not null,
    deleted boolean not null default false,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_callsign;").await?;
        Ok(())
    }
}
