use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            create table sigint_settlement (
                id bigserial primary key,
                name text not null,
                lat float8 not null,
                lon float8 not null,
                alt_names jsonb not null,
                deleted bool not null default false,
                openstreetmap_id int,
                updated_by text references login(login),
                updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_settlement;")
            .await?;
        Ok(())
    }
}
