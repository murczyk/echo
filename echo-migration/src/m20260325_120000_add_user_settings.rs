use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create type user_settings_tags_layout as enum ('full', 'compact', 'hidden');

            create table if not exists user_settings (
                id bigserial primary key,
                login text not null unique references login(login) on update cascade on delete cascade,
                tags_layout user_settings_tags_layout not null default 'compact',
                disable_auto_scroll boolean not null default false,
                updated_at timestamp without time zone not null default (now() at time zone 'utc')
            );
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop table if exists user_settings;
            drop type if exists user_settings_tags_layout;
            "#,
        )
        .await?;
        Ok(())
    }
}
