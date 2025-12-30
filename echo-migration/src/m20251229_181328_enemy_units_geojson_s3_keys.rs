use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table enemy_units_geojson
                add column geojson_s3_id text,
                add column kml_s3_id text;
            ",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            alter table enemy_units_geojson
                drop column geojson_s3_id,
                drop column kml_s3_id;
            ",
        )
        .await?;

        Ok(())
    }
}
