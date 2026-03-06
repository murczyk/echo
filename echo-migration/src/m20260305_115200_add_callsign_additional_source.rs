use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table callsign_additional_source (
                id bigserial primary key,
                sigint_callsign_id bigint not null references sigint_callsign(id) on delete cascade,
                source_id bigint not null references source(id) on delete cascade,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create index callsign_additional_source_sigint_callsign_id_source_id_idx on callsign_additional_source (sigint_callsign_id, source_id);
            "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop table if exists callsign_additional_source;
            "#,
        )
        .await?;
        Ok(())
    }
}
