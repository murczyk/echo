use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table sigint_network_encryption_key add column key_hash text;
            alter table sigint_network_encryption_key alter column key drop not null;
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table sigint_network_encryption_key alter column key set not null;
            alter table sigint_network_encryption_key drop column if exists key_hash;
            ",
        )
            .await?;
        Ok(())
    }
}
