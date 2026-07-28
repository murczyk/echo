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
                create index if not exists sigint_inbox_item_unit_v2_datetime_idx
                    on sigint_inbox_item (unit_v2, datetime)
                    include (id)
                    where unit_v2 is not null and unit_v2 <> '';
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "drop index if exists sigint_inbox_item_unit_v2_datetime_idx;",
            )
            .await?;
        Ok(())
    }
}
