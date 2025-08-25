use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"update sigint_network_freq
            set freq = freq || repeat('0', 4 - length(split_part(freq, '.', 2)))
            where freq ~ '^\d+(\.\d{1,3})?$';"#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"update sigint_network_freq
            set freq = freq
            where freq ~ '^\d+(\.\d{1,3})?$';"#,
        )
        .await?;

        Ok(())
    }
}
