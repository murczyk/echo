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
                    ADD COLUMN IF NOT EXISTS rer_duty_test_enabled boolean NOT NULL DEFAULT false;
                ALTER TABLE system_settings
                    ADD COLUMN IF NOT EXISTS rer_duty_test_since_ms int8 NOT NULL DEFAULT 0;
                ALTER TABLE system_settings
                    ADD COLUMN IF NOT EXISTS rer_duty_test_limit int8 NOT NULL DEFAULT 1;
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
                    DROP COLUMN IF EXISTS rer_duty_test_limit;
                ALTER TABLE system_settings
                    DROP COLUMN IF EXISTS rer_duty_test_since_ms;
                ALTER TABLE system_settings
                    DROP COLUMN IF EXISTS rer_duty_test_enabled;
                ",
        )
            .await?;
        Ok(())
    }
}
