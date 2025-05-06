use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("
            create table freq_location (
                id bigserial primary key,
                freq text not null,
                location text not null,
                datetime timestamp without time zone,
                deleted boolean not null default false,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            ").await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table freq_location;").await?;
        Ok(())
    }
}
