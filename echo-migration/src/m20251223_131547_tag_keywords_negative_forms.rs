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
                alter table tag_keyword add column keyword_negative_forms text[] not null default array[]::text[];
                alter table tag_keyword alter column keyword_negative_forms drop default;

                update tag_keyword
                    set keyword_negative_forms = keyword_forms
                    , keyword_forms = array[]::text[]
                where is_positive = false;

                alter table tag_keyword drop column is_positive;
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
                alter table tag_keyword add column is_positive boolean not null default true;
                alter table tag_keyword alter column is_positive drop default;

                update tag_keyword
                    set keyword_forms = keyword_negative_forms
                    , is_positive = false
                where array_length(keyword_negative_forms, 1) > 0;

                alter table tag_keyword drop column keyword_negative_forms;
                "#,
            )
            .await?;
        Ok(())
    }
}
