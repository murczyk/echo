use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table system_settings
                    add column if not exists peleng_bounds_enabled boolean not null default false;
                alter table system_settings
                    add column if not exists peleng_bounds_top_left_lat double precision;
                alter table system_settings
                    add column if not exists peleng_bounds_top_left_lng double precision;
                alter table system_settings
                    add column if not exists peleng_bounds_bottom_right_lat double precision;
                alter table system_settings
                    add column if not exists peleng_bounds_bottom_right_lng double precision;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table system_settings
                    drop column if exists peleng_bounds_bottom_right_lng;
                alter table system_settings
                    drop column if exists peleng_bounds_bottom_right_lat;
                alter table system_settings
                    drop column if exists peleng_bounds_top_left_lng;
                alter table system_settings
                    drop column if exists peleng_bounds_top_left_lat;
                alter table system_settings
                    drop column if exists peleng_bounds_enabled;
            "#,
        )
        .await?;
        Ok(())
    }
}
