use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                alter table palitra add column last_uploaded_at timestamp without time zone;
                alter table palitra_point add column label text;
               "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "
                alter table palitra drop column last_uploaded_at;
                alter table palitra_point drop column label;",
            )
            .await;
        Ok(())
    }
}
