use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
alter table sigint_unit drop column batalion;
alter table sigint_unit add column battalion text not null default '';
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
alter table sigint_unit drop column battalion;
alter table sigint_unit add column batalion text not null default '';
",
        )
        .await?;
        Ok(())
    }
}
