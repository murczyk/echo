use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create index if not exists palitra_point_palitra_id_label_idx
                on palitra_point (palitra_id, label)
                where deleted = false;

            create index if not exists palitra_point_label_idx
                on palitra_point (label)
                where deleted = false;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists palitra_point_palitra_id_label_idx;
            drop index if exists palitra_point_label_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}
