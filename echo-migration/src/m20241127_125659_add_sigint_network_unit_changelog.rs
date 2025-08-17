use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                CREATE TABLE sigint_network_unit_changelog (
                id bigserial primary key,
                sigint_network_unit_id int8 not null references sigint_network_unit(id),
                login text NOT NULL,
                action text NOT NULL,
                created_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
                new_value jsonb,
                old_value jsonb,
                req jsonb
                );
                ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_network_unit_changelog;")
            .await?;
        Ok(())
    }
}
