use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TYPE sigint_network_freq_action_enum RENAME TO changelog_action_enum;") 
        .await?;

        db.execute_unprepared(
            "
                CREATE TABLE sigint_network_changelog (
                id bigserial primary key,
                sigint_network_id int8 not null references sigint_network(id),
                login text NOT NULL,
                action changelog_action_enum NOT NULL,
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
        db.execute_unprepared("DROP TABLE sigint_network_changelog;")
            .await?;

        db.execute_unprepared(
            "ALTER TYPE changelog_action_enum RENAME TO sigint_network_freq_action_enum;",
        )
        .await?;
        Ok(())
    }
}
