use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table goi_palitra_sync
                drop constraint if exists goi_palitra_sync_goi_integration_id_remote_relative_path_key;

            create unique index if not exists idx_goi_palitra_sync_unique_remote_palitra
                on goi_palitra_sync (goi_integration_id, remote_relative_path, palitra_id)
                where palitra_id is not null;

            create unique index if not exists idx_goi_palitra_sync_unique_remote_unmatched
                on goi_palitra_sync (goi_integration_id, remote_relative_path)
                where palitra_id is null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop index if exists idx_goi_palitra_sync_unique_remote_unmatched;
            drop index if exists idx_goi_palitra_sync_unique_remote_palitra;

            delete from goi_palitra_sync stale
            using goi_palitra_sync retained
            where stale.goi_integration_id = retained.goi_integration_id
              and stale.remote_relative_path = retained.remote_relative_path
              and stale.id > retained.id;

            alter table if exists goi_palitra_sync
                add constraint goi_palitra_sync_goi_integration_id_remote_relative_path_key
                unique (goi_integration_id, remote_relative_path);
            "#,
        )
        .await?;
        Ok(())
    }
}
