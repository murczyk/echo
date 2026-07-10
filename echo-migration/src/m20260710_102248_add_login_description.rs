use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table login add column if not exists description text;

            update login
            set description = 'Віртуальний юзер для автоматичних дій в системі ЕХО'
            where login = 'system';
            ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            update login
            set description = null
            where login = 'system';

            alter table login drop column if exists description;
            ",
        )
        .await?;
        Ok(())
    }
}
