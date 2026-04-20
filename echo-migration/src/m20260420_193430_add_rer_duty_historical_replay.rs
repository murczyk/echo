use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                ALTER TABLE system_settings
                    ADD COLUMN IF NOT EXISTS rer_duty_insert_historical_interceptions boolean NOT NULL DEFAULT false;
                ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
                ALTER TABLE system_settings
                    DROP COLUMN IF EXISTS rer_duty_insert_historical_interceptions;
                ",
        )
        .await?;
        Ok(())
    }
}
