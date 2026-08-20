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
create table device_settings (
    id smallint primary key check (id = 1),
    mattermost_webhook_url text,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null
);

insert into device_settings (id) values (1);
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
drop table device_settings;
                "#,
            )
            .await?;
        Ok(())
    }
}
