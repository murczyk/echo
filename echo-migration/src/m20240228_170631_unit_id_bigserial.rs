use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "create sequence sigint_unit_id_seq owned by sigint_unit.id;",
        )
        .await?;
        db.execute_unprepared(
            "alter table sigint_unit alter column id set default nextval('sigint_unit_id_seq');", 
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "alter table sigint_unit alter column id drop default;",
        )
        .await?;
        db.execute_unprepared("drop sequence sigint_unit_id_seq;")
            .await?;
        Ok(())
    }
}
