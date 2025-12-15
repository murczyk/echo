use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table signal_group drop column if exists short_note;
            alter table signal_group drop column if exists long_note;
            ",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table signal_group add column if not exists short_note text;
            alter table signal_group add column if not exists long_note text;
            ",
        )
        .await?;

        Ok(())
    }
}
