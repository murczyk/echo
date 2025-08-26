use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table signal_group add column if not exists deleted boolean not null default false;
            alter table whatsapp_group add column if not exists deleted boolean not null default false;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table signal_group drop column if exists deleted;
            alter table whatsapp_group drop column if exists deleted;
            "#,
        )
        .await?;
        Ok(())
    }
}
