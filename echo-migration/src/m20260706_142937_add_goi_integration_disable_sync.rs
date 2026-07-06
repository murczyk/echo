use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table goi_integration
                add column if not exists disable_sync bool;

            update goi_integration
            set disable_sync = case
                when nullif(trim(coalesce(ssh_host, '')), '') is not null
                    and nullif(trim(coalesce(ssh_user, '')), '') is not null
                then false
                else true
            end
            where disable_sync is null;

            alter table goi_integration
                alter column disable_sync set default false;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table goi_integration
                drop column if exists disable_sync;
            "#,
        )
        .await?;
        Ok(())
    }
}
