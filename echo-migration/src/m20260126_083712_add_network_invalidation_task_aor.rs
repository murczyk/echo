use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table network_invalidation_task add column aor_id bigint REFERENCES area_of_responsibility(id) ON DELETE set null;
            alter table network_invalidation_task add column group_master_key text REFERENCES signal_group(master_key) ON DELETE set null;
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table network_invalidation_task drop column group_master_key;
            alter table network_invalidation_task drop column aor_id;
            "#,
        )
        .await?;
        Ok(())
    }
}
