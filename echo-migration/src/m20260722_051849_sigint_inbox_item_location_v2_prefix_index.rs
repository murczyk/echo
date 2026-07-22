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
                create index if not exists sigint_inbox_item_location_v2_prefix_idx
                    on sigint_inbox_item ((location_v2 collate "C"))
                    where location_v2 is not null and location_v2 <> '';
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                drop index if exists sigint_inbox_item_location_v2_prefix_idx;
                "#,
            )
            .await?;
        Ok(())
    }
}
