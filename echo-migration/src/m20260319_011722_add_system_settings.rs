use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table system_settings (
                id bigserial primary key,
                rer_analysis_units_exact_match_only_default boolean not null default true,
                created_at timestamp without time zone default (now() at time zone 'utc') not null,
                updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                updated_by text references login(login),
                deleted boolean not null default false
            );

            create unique index system_settings_single_active_idx
                on system_settings ((1))
                where deleted = false;

            insert into system_settings (
                rer_analysis_units_exact_match_only_default,
                updated_by,
                deleted
            )
            values (true, 'system', false);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop table if exists system_settings;
            "#,
        )
        .await?;
        Ok(())
    }
}
