use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            alter table datasource_group set (
                fillfactor = 70,
                autovacuum_vacuum_scale_factor = 0,
                autovacuum_vacuum_threshold = 1000,
                autovacuum_analyze_scale_factor = 0,
                autovacuum_analyze_threshold = 200
            );

            alter table datasource set (
                fillfactor = 70,
                autovacuum_vacuum_scale_factor = 0,
                autovacuum_vacuum_threshold = 100,
                autovacuum_analyze_scale_factor = 0,
                autovacuum_analyze_threshold = 50
            );
            "#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            r#"
            alter table datasource_group reset (
                fillfactor,
                autovacuum_vacuum_scale_factor,
                autovacuum_vacuum_threshold,
                autovacuum_analyze_scale_factor,
                autovacuum_analyze_threshold
            );

            alter table datasource reset (
                fillfactor,
                autovacuum_vacuum_scale_factor,
                autovacuum_vacuum_threshold,
                autovacuum_analyze_scale_factor,
                autovacuum_analyze_threshold
            );
            "#,
        )
        .await?;

        Ok(())
    }
}
