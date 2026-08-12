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
alter table if exists sigint_unit
    add column if not exists orbit_note text;

update sigint_unit
set orbit_note = ''
where orbit_note is null;
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
alter table if exists sigint_unit
    drop column if exists orbit_note;
                "#,
            )
            .await?;
        Ok(())
    }
}
