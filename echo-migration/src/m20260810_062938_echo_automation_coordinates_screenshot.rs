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
alter table echo_automation
    add column if not exists coordinates_screenshot boolean;

update echo_automation
set coordinates_screenshot = false
where coordinates_screenshot is null;

alter table echo_automation
    alter column coordinates_screenshot set default false,
    alter column coordinates_screenshot set not null;
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
alter table echo_automation
    drop column if exists coordinates_screenshot;
                "#,
            )
            .await?;
        Ok(())
    }
}
