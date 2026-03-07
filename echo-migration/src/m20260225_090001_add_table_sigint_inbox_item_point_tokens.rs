use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table if not exists sigint_inbox_item_point_tokens (
                id bigserial primary key,
                sigint_inbox_item_id int8 not null references sigint_inbox_item(id) on delete cascade,
                scope_type text not null,
                scope_id text,
                point_tokens jsonb not null,
                unique (sigint_inbox_item_id, scope_type, scope_id)
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
            drop table if exists sigint_inbox_item_point_tokens;
            "#,
        )
        .await?;
        Ok(())
    }
}
