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
                create schema if not exists echo_analytics;
                revoke all on schema echo_analytics from public;
                create table echo_analytics.heartbeat (
                    singleton boolean primary key default true check (singleton),
                    nonce uuid not null,
                    updated_at timestamptz not null default clock_timestamp()
                );
                insert into echo_analytics.heartbeat (singleton, nonce)
                values (true, '00000000-0000-0000-0000-000000000000');
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
                drop table if exists echo_analytics.heartbeat;
                drop schema if exists echo_analytics;
                "#,
            )
            .await?;
        Ok(())
    }
}
