use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table if not exists computer_name (
                    id bigserial primary key,
                    name text,
                    login text references login(login) not null,
                    created_at timestamp without time zone not null default (now() at time zone 'utc')
                );

            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                alter table sigint_inbox_item
                    add column if not exists computer_name_id int8 references computer_name(id) on delete set null;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                create index if not exists idx_sii_computer_name_id on sigint_inbox_item(computer_name_id);
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists idx_sii_computer_name_id;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                alter table sigint_inbox_item
                    drop column if exists computer_name_id;
            "#,
        )
        .await?;

        db.execute_unprepared(
            r#"
                drop table if exists computer_name;
            "#,
        )
        .await?;
        Ok(())
    }
}
