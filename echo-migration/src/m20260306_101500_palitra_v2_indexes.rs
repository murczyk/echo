use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create index if not exists palitra_geometry_palitra_id_updated_idx
                on palitra_geometry (palitra_id, updated_at desc, id desc)
                where deleted = false;

            create index if not exists palitra_point_palitra_geometry_id_lat_lng_idx
                on palitra_point (palitra_geometry_id, lat, lng)
                where deleted = false;

            create index if not exists palitra_point_palitra_geometry_id_label_idx
                on palitra_point (palitra_geometry_id, label)
                where deleted = false and label is not null;

            create index if not exists palitra_point_palitra_geometry_id_label_lower_pat_idx
                on palitra_point (palitra_geometry_id, lower(label) text_pattern_ops)
                where deleted = false and label is not null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists palitra_point_palitra_geometry_id_label_lower_pat_idx;
            drop index if exists palitra_point_palitra_geometry_id_label_idx;
            drop index if exists palitra_point_palitra_geometry_id_lat_lng_idx;
            drop index if exists palitra_geometry_palitra_id_updated_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}
