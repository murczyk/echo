use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table area_of_responsibility add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
                alter table sigint_network_aor add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
                alter table sigint_zone_aor add column sigint_origin_id bigint references sigint_origin(id) ON DELETE SET NULL;
            "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table area_of_responsibility drop column sigint_origin_id;
                alter table sigint_network_aor drop column sigint_origin_id;
                alter table sigint_zone_aor drop column sigint_origin_id;
            "#,
        )
        .await?;
        Ok(())
    }
}
