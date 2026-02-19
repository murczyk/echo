use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("
            create type network_invalidation_worker_status as ENUM ('sleep', 'triage', 'working');
            create table network_invalidation_worker (
                id bigserial primary key,
                tag text not null,
                status network_invalidation_worker_status not null,
                updated_at timestamp without time zone default (now() at time zone 'utc') not null
            );
            insert into network_invalidation_worker (tag, status) values ('recent', 'sleep');
            insert into network_invalidation_worker (tag, status) values ('old', 'sleep');

            "
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
        drop table network_invalidation_worker;
        drop type network_invalidation_worker_status;
        ",
        )
        .await?;

        Ok(())
    }
}
