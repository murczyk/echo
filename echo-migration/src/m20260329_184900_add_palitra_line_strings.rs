use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            SELECT AddGeometryColumn('palitra_geometry', 'line_string', 4326, 'LINESTRING', 2);
            SELECT AddGeometryColumn('palitra_geometry', 'multi_line_string', 4326, 'MULTILINESTRING', 2);
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table palitra_geometry
                drop column if exists multi_line_string,
                drop column if exists line_string;
            "#,
        )
        .await?;
        Ok(())
    }
}
