use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"ALTER TABLE sigint_network
                    ALTER COLUMN active_from DROP NOT NULL,
                    ALTER COLUMN active_from DROP DEFAULT;"#,
        )
        .await?;

        db.execute_unprepared("drop table sigint_network_activity_history;")
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            UPDATE sigint_network sn
                SET active_from = now() AT TIME ZONE 'utc'
                WHERE sn.active_from IS NULL;

            ALTER TABLE sigint_network ALTER COLUMN active_from SET NOT NULL;"#,
        )
        .await?;

        db.execute_unprepared(
            "
            create table sigint_network_activity_history (
                id bigserial primary key,
                sigint_network_id bigint not null REFERENCES sigint_network(id) ON DELETE CASCADE,
                active_from timestamp without time zone not null,
                active_to timestamp without time zone not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );",
        )
            .await?;

        Ok(())
    }
}
