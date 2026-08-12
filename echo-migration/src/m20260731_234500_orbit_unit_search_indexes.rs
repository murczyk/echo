use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create extension if not exists pg_trgm;

                create index if not exists orbit_unit_generative_full_name_trgm_idx
                    on orbit_unit using gin (generative_unit_name_full gin_trgm_ops)
                    where deleted = false;

                create index if not exists orbit_unit_operational_full_name_trgm_idx
                    on orbit_unit using gin (operational_unit_name_full gin_trgm_ops)
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
                drop index if exists orbit_unit_operational_full_name_trgm_idx;
                drop index if exists orbit_unit_generative_full_name_trgm_idx;
            "#,
        )
        .await?;
        Ok(())
    }
}
