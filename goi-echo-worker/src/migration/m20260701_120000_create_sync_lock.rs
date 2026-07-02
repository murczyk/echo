use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                    create table if not exists sync_lock (
                        id uuid primary key,
                        created_at timestamptz not null,
                        updated_at timestamptz not null,
                        released_at timestamptz
                    );

                    create index if not exists idx_sync_lock_live
                        on sync_lock (released_at, updated_at);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                    drop index if exists idx_sync_lock_live;
                    drop table if exists sync_lock;
                "#,
            )
            .await?;
        Ok(())
    }
}
