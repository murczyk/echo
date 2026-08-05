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
    add column if not exists hide_orbit_data boolean;

update system_settings
set hide_orbit_data = false
where hide_orbit_data is null;

alter table if exists system_settings
    alter column hide_orbit_data set default false,
    alter column hide_orbit_data set not null;
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
alter table if exists system_settings
    drop column if exists hide_orbit_data;
                "#,
            )
            .await?;
        Ok(())
    }
}
