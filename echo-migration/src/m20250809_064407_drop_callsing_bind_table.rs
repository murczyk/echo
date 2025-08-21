use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE sigint_callsign_bind;")
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                CREATE TABLE sigint_callsign_bind (
                    id bigserial primary key,
                    callsign_id bigint not null references sigint_callsign(id),
                    deleted boolean not null default false,
                    freq text not null,
                    comment text,
                    date text,
                    updated_by text not null references login(login),
                    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );
                ",
        )
        .await?;
        Ok(())
    }
}
