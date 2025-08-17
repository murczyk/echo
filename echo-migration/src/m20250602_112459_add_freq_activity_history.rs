use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                alter table sigint_network_freq add column active_from timestamp without time zone;
                alter table sigint_network_freq add column active_to timestamp without time zone;

                UPDATE sigint_network_freq
                SET active_from = created_at
                WHERE active_from IS NULL;

                ALTER TABLE sigint_network_freq ALTER COLUMN active_from SET NOT NULL;

                UPDATE sigint_network_freq
                SET active_to = now()
                WHERE deleted;

                alter TABLE sigint_network_freq drop column deleted;
                ",
        )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter TABLE sigint_network_freq add column deleted bool not null default false;

            UPDATE sigint_network_freq
            SET deleted = true where active_to is not null;
            alter TABLE sigint_network_freq drop column active_from;
            alter TABLE sigint_network_freq drop column active_to;",
        )
        .await?;

        Ok(())
    }
}
