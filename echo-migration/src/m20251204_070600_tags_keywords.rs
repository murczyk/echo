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
                create table tag_keyword (
                    tag_keyword_id bigserial primary key,
                    tag_id bigint not null references tag(id),
                    is_positive boolean not null,
                    keyword text not null,
                    keyword_forms text[] not null
                );

                create index idx_tag_keyword_tag_id on tag_keyword(tag_id);
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
                drop table tag_keyword;
                "#,
            )
            .await?;
        Ok(())
    }
}
