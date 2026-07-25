use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                create index if not exists sigint_network_callsign_lower_network_idx
                    on sigint_network_callsign (
                        lower(sigint_callsign),
                        sigint_network_id,
                        id
                    )
                    where deleted = false;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "drop index if exists sigint_network_callsign_lower_network_idx;",
            )
            .await?;
        Ok(())
    }
}
