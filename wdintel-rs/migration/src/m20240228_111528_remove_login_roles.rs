use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table organism_role;").await?;
        db.execute_unprepared("drop table login_role;").await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table organism_role (
    id serial primary key,
    name varchar(255),
    organism_id int references organism(id),
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
",
        )
        .await?;
        db.execute_unprepared(
            "
create table login_role (
    id serial primary key,
    name varchar(255),
    login text references login(login),
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
",
        )
        .await?;
        Ok(())
    }
}
