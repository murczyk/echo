use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table sigint_network_callsign (
    id bigserial primary key,
    sigint_network_id bigint not null REFERENCES sigint_network(id) ON DELETE CASCADE,
    sigint_callsign_id bigint not null REFERENCES sigint_callsign(id) ON DELETE CASCADE,
    deleted bool not null default false,
    is_reported bool not null default false,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_network_callsign;")
            .await?;
        Ok(())
    }
}
