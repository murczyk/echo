use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table if not exists user_settings (
                login text not null primary key references login(login) on update cascade on delete cascade,
                prefs jsonb not null default '{}'::jsonb,
                updated_at timestamp without time zone not null default (now() at time zone 'utc')
            );
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(r#"drop table if exists user_settings;"#)
            .await?;
        Ok(())
    }
}
