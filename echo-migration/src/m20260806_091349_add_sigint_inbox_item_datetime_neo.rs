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
alter table sigint_inbox_item
    add column datetime_neo timestamp without time zone;

create index sigint_inbox_item_datetime_neo_idx
    on sigint_inbox_item (datetime_neo desc);
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
drop index sigint_inbox_item_datetime_neo_idx;

alter table sigint_inbox_item
    drop column datetime_neo;
                "#,
            )
            .await?;
        Ok(())
    }
}
