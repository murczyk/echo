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
                id bigserial primary key,
                login text not null unique references login(login) on update cascade on delete cascade,
                message_card_layout text not null default ''
                    check (message_card_layout in ('', 'dividers', 'fluid')),
                tags_layout text not null default ''
                    check (tags_layout in ('', 'full', 'compact', 'hidden')),
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
