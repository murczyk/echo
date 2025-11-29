use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                create table sigint_inbox_item_tag (
                    id bigserial primary key, 
                    sigint_inbox_item_id bigint not null references sigint_inbox_item(id) on delete cascade,
                    tag_id bigint not null references tag(id),
                    confidence float8 not null default(1.0),
                    login text null references login(login),
                    model text null
                );
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                drop table if exists sigint_inbox_item_tag;
                "#,
            )
            .await?;
        Ok(())
    }
}
