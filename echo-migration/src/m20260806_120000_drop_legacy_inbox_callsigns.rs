use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table sigint_inbox_item
    drop column callsigns,
    drop column callsigns_alg1,
    drop column callsigns_alg2;
                "#,
            )
            .await
            .map(|_| ())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table sigint_inbox_item
    add column callsigns jsonb,
    add column callsigns_alg1 jsonb,
    add column callsigns_alg2 jsonb;
                "#,
            )
            .await
            .map(|_| ())
    }
}
