use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "
                alter table system_settings
                    add column report_chunking_hours integer,
                    add column limit_big_reports boolean;

                update system_settings
                set report_chunking_hours = 24,
                    limit_big_reports = false;

                alter table system_settings
                    alter column report_chunking_hours set default 24,
                    alter column report_chunking_hours set not null,
                    alter column limit_big_reports set default false,
                    alter column limit_big_reports set not null,
                    add constraint system_settings_report_chunking_hours_positive
                        check (report_chunking_hours > 0);
                ",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "
                alter table system_settings
                    drop constraint system_settings_report_chunking_hours_positive,
                    drop column limit_big_reports,
                    drop column report_chunking_hours;
                ",
            )
            .await?;
        Ok(())
    }
}
