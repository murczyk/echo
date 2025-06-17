use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            CREATE TYPE deactivation_reason_enum as ENUM ('admin', 'inactive');
            ALTER TABLE login ADD COLUMN last_active_at TIMESTAMP WITHOUT TIME ZONE;
            ALTER TABLE login ADD COLUMN deactivation_reason deactivation_reason_enum;
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            ALTER TABLE login DROP COLUMN last_active_at;
            ALTER TABLE login DROP COLUMN deactivation_reason;
            DROP TYPE deactivation_reason_enum;",
        )
        .await?;
        Ok(())
    }
}
