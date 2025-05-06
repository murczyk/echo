use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
alter table sigint_unit drop column prefix;
alter table sigint_unit add column name text not null;
alter table sigint_unit add column comment text not null;
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("alter table sigint_unit drop column name;")
            .await?;
        db.execute_unprepared("alter table sigint_unit drop column comment;")
            .await?;
        db.execute_unprepared("alter table sigint_unit add column prefix text not null default '';")
            .await?;
        Ok(())
    }
}
