use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            create table if not exists echo_swapp_sync_state (
                key text primary key,
                paused boolean not null default false,
                updated_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            ",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            drop table echo_swapp_sync_state;
            ",
        )
        .await?;
        Ok(())
    }
}
