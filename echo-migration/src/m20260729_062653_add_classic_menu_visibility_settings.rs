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
alter table if exists system_settings
    add column if not exists show_classic_duty boolean,
    add column if not exists show_classic_analysis boolean;

update system_settings
set show_classic_duty = coalesce(show_classic_duty, true),
    show_classic_analysis = coalesce(show_classic_analysis, true)
where show_classic_duty is null
   or show_classic_analysis is null;

alter table if exists system_settings
    alter column show_classic_duty set default true,
    alter column show_classic_duty set not null,
    alter column show_classic_analysis set default true,
    alter column show_classic_analysis set not null;

alter table if exists user_settings
    add column if not exists show_classic_duty boolean,
    add column if not exists show_classic_analysis boolean;

update user_settings
set show_classic_duty = coalesce(show_classic_duty, false),
    show_classic_analysis = coalesce(show_classic_analysis, false)
where show_classic_duty is null
   or show_classic_analysis is null;

alter table if exists user_settings
    alter column show_classic_duty set default false,
    alter column show_classic_duty set not null,
    alter column show_classic_analysis set default false,
    alter column show_classic_analysis set not null;
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
    drop column if exists show_classic_analysis,
    drop column if exists show_classic_duty;

alter table if exists system_settings
    drop column if exists show_classic_analysis,
    drop column if exists show_classic_duty;
                "#,
            )
            .await?;
        Ok(())
    }
}
