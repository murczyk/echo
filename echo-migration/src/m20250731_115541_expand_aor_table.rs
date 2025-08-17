use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table area_of_responsibility rename column left_settelment to left_settlement;
            alter table area_of_responsibility rename column right_settelment to right_settlement;
            alter table area_of_responsibility add column deleted bool not null default false;
            alter table area_of_responsibility add column is_top_level bool not null default false;
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table area_of_responsibility drop column is_top_level;
            alter table area_of_responsibility drop column deleted;
            alter table area_of_responsibility rename column left_settlement to left_settelment;
            alter table area_of_responsibility rename column right_settlement to right_settelment;
            ",        )
            .await?;
        Ok(())
    }
}
