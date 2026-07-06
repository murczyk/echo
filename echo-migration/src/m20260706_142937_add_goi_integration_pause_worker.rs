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
                add column if not exists pause_worker bool;

            update goi_integration
            set pause_worker = case
                when nullif(trim(coalesce(ssh_host, '')), '') is not null
                    and nullif(trim(coalesce(ssh_user, '')), '') is not null
                then false
                else true
            end
            where pause_worker is null;

            alter table goi_integration
                alter column pause_worker set default false,
                alter column pause_worker set not null;
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
                drop column if exists pause_worker;
            "#,
        )
        .await?;
        Ok(())
    }
}
