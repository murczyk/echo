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
create index failed_inbox_unit_bad_text_idx
    on failed_inbox_unit (
        lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g'))
    )
    where deleted = false and is_bad_data = true;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "drop index if exists failed_inbox_unit_bad_text_idx;",
            )
            .await?;
        Ok(())
    }
}
