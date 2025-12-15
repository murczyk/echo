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
                create table tag_suggestion_worker_queue (
                    sigint_inbox_item_id bigint primary key
                );

                alter table tag_keyword add column is_regex boolean not null default false;
                alter table tag_keyword alter column is_regex drop default;
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
                alter table tag_keyword drop column is_regex;
                drop table tag_suggestion_worker_queue;
                "#,
            )
            .await?;
        Ok(())
    }
}
