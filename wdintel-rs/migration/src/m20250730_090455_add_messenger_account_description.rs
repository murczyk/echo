use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table messenger_account add column display_name text not null default '';
            alter table messenger_account add column description text;
            alter table signal_group add column short_note text;
            alter table signal_group add column long_note text;
            ",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table messenger_account drop column display_name;
            alter table messenger_account drop column description;
            alter table signal_group drop column short_note;
            alter table signal_group drop column long_note;
            ",
        )
        .await?;

        Ok(())
    }
}
