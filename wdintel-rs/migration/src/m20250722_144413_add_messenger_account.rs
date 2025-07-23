use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "
            create type account_status as enum ('ready', 'paused', 'active');
            create table messenger_account (
                id bigserial primary key,
                status account_status not null default 'ready',
                echo_client_lock_id bigint references echo_client_lock(id) ON DELETE CASCADE,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
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
            drop table messenger_account;
            drop type account_status;
            ",
        )
        .await?;

        Ok(())
    }
}
