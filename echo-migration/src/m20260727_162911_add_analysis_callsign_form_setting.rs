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
alter table if exists user_settings
    add column if not exists show_analysis_callsign_add_form boolean;

update user_settings
set show_analysis_callsign_add_form = false
where show_analysis_callsign_add_form is null;

alter table if exists user_settings
    alter column show_analysis_callsign_add_form set default false,
    alter column show_analysis_callsign_add_form set not null;
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
alter table if exists user_settings
    drop column if exists show_analysis_callsign_add_form;
                "#,
            )
            .await?;
        Ok(())
    }
}
