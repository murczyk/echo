use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "ALTER TABLE signal_group ADD CONSTRAINT signal_group_datasoucr_id_fkey FOREIGN KEY (datasource_id) REFERENCES datasource (id)",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "ALTER TABLE signal_group DROP CONSTRAINT signal_group_datasoucr_id_fkey"
            )
            .await;
        Ok(())
    }
}
