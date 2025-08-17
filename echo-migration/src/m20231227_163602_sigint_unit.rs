use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table sigint_unit (
    id int8 not null primary key,
    prefix text not null default '',
    company text not null default '',
    batalion text not null default '',
    regiment text not null default '',
    division text not null default '',
    army text not null default '',
    active boolean not null default true,
    deleted boolean not null default false,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    created_by text not null
);
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_unit;").await?;
        Ok(())
    }
}
